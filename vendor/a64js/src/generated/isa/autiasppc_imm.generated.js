export const ENCODINGS = [
    {
        "instructionId": "AUTIASPPC_imm",
        "encodingId": "AUTIASPPC_only_dp_1src_imm",
        "mnemonic": "AUTIASPPC",
        "className": "Integer",
        "fileName": "autiasppc_imm.xml",
        "mask": 4292870175,
        "value": 4085252127,
        "bitCount": 16,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 21,
                "width": 2
            },
            {
                "name": "imm16",
                "lsb": 5,
                "width": 16
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_PAuth_LR"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_PAuth_LR",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "label-from-imm16-negative"
    }
];
