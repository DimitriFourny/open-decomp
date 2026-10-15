export const ENCODINGS = [
    {
        "instructionId": "AUTIBSPPC_imm",
        "encodingId": "AUTIBSPPC_only_dp_1src_imm",
        "mnemonic": "AUTIBSPPC",
        "className": "Integer",
        "fileName": "autibsppc_imm.xml",
        "mask": 4292870175,
        "value": 4087349279,
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
