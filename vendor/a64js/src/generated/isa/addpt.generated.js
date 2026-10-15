export const ENCODINGS = [
    {
        "instructionId": "ADDPT",
        "encodingId": "ADDPT_64_addsub_pt",
        "mnemonic": "ADDPT",
        "className": "Integer",
        "fileName": "addpt.xml",
        "mask": 4292927488,
        "value": 2583699456,
        "bitCount": 14,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm3",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_CPA"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_CPA",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "checked-pointer-add-sub"
    }
];
