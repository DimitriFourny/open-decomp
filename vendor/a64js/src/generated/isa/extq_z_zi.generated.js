export const ENCODINGS = [
    {
        "instructionId": "extq_z_zi",
        "encodingId": "extq_z_zi_des",
        "mnemonic": "EXTQ",
        "className": "SVE2",
        "fileName": "extq_z_zi.xml",
        "mask": 4293983232,
        "value": 90186752,
        "bitCount": 18,
        "fields": [
            {
                "name": "imm4",
                "lsb": 16,
                "width": 4
            },
            {
                "name": "Zm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-ext"
    }
];
